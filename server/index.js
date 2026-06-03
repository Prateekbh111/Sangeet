#!/usr/bin/env node
// BeatSync signaling server.
// Tiny WebSocket relay that pairs extension instances by room code AND
// owns role assignment: first joiner = leader; on leader disconnect the
// next-oldest peer is promoted automatically. Host transfer goes through
// REQUEST_HOST → leader → GRANT_HOST.
//
// Wire protocol (JSON):
//   client → server { t:'JOIN',          room, peerId }
//   server → joiner { t:'JOINED',        peers: [otherPeerId,...] }
//   server → all    { t:'ROLE_ASSIGN',   role, leaderPeerId, members: [{peerId,role}] }
//   server → other  { t:'PEER_JOINED',   peerId }
//   server → other  { t:'PEER_LEFT',     peerId }
//   client → server { t:'SIGNAL',        to, payload }
//   server → other  { t:'SIGNAL',        from, payload }
//   client → server { t:'REQUEST_HOST' }
//   server → leader { t:'HOST_REQUEST',  from }
//   client → server { t:'GRANT_HOST',    to }
//   client → server { t:'DENY_HOST',     to }
//   server → reqer  { t:'HOST_DENIED',   from }

import { WebSocketServer } from 'ws';
import os from 'node:os';

const PORT = Number(process.env.PORT ?? 8787);
const wss = new WebSocketServer({ port: PORT, host: '0.0.0.0' });

/** @type {Map<string, { leader: string|null, members: Array<{ws: any, peerId: string, joinedAt: number}> }>} */
const rooms = new Map();

function lanIps() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    if (!ifaces) continue;
    for (const i of ifaces) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

function getRoom(name) {
  let r = rooms.get(name);
  if (!r) {
    r = { leader: null, members: [] };
    rooms.set(name, r);
  }
  return r;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastRoom(room, obj, except) {
  const r = rooms.get(room);
  if (!r) return;
  for (const m of r.members) {
    if (m.ws === except) continue;
    send(m.ws, obj);
  }
}

function broadcastRoleAssign(room) {
  const r = rooms.get(room);
  if (!r) return;
  const members = r.members.map((m) => ({
    peerId: m.peerId,
    role: m.peerId === r.leader ? 'leader' : 'follower',
  }));
  for (const m of r.members) {
    send(m.ws, {
      t: 'ROLE_ASSIGN',
      role: m.peerId === r.leader ? 'leader' : 'follower',
      leaderPeerId: r.leader,
      members,
    });
  }
}

wss.on('connection', (ws) => {
  ws.peerId = null;
  ws.room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'JOIN') {
      if (typeof msg.room !== 'string' || typeof msg.peerId !== 'string') return;
      ws.peerId = msg.peerId;
      ws.room = msg.room;
      const r = getRoom(msg.room);
      const others = r.members.map((m) => m.peerId);
      broadcastRoom(msg.room, { t: 'PEER_JOINED', peerId: msg.peerId });
      r.members.push({ ws, peerId: msg.peerId, joinedAt: Date.now() });
      // First peer in room becomes leader.
      if (!r.leader) r.leader = msg.peerId;
      send(ws, { t: 'JOINED', peers: others });
      broadcastRoleAssign(msg.room);
      console.log(`[sig] ${msg.peerId} joined room=${msg.room} (size=${r.members.length}) leader=${r.leader}`);
      return;
    }

    if (msg.t === 'SIGNAL') {
      const r = ws.room ? rooms.get(ws.room) : null;
      if (!r) return;
      const to = msg.to;
      for (const m of r.members) {
        if (m.ws === ws) continue;
        if (m.peerId === to) {
          send(m.ws, { t: 'SIGNAL', from: ws.peerId, payload: msg.payload });
          break;
        }
      }
      return;
    }

    if (msg.t === 'REQUEST_HOST') {
      const r = ws.room ? rooms.get(ws.room) : null;
      if (!r || !r.leader || r.leader === ws.peerId) return;
      const leader = r.members.find((m) => m.peerId === r.leader);
      if (leader) {
        send(leader.ws, { t: 'HOST_REQUEST', from: ws.peerId });
        console.log(`[sig] HOST_REQUEST ${ws.peerId} → ${r.leader} (room=${ws.room})`);
      }
      return;
    }

    if (msg.t === 'GRANT_HOST') {
      const r = ws.room ? rooms.get(ws.room) : null;
      if (!r || r.leader !== ws.peerId) return;
      if (typeof msg.to !== 'string') return;
      if (!r.members.find((m) => m.peerId === msg.to)) return;
      console.log(`[sig] GRANT_HOST ${ws.peerId} → ${msg.to} (room=${ws.room})`);
      r.leader = msg.to;
      broadcastRoleAssign(ws.room);
      return;
    }

    if (msg.t === 'DENY_HOST') {
      const r = ws.room ? rooms.get(ws.room) : null;
      if (!r || r.leader !== ws.peerId) return;
      if (typeof msg.to !== 'string') return;
      const target = r.members.find((m) => m.peerId === msg.to);
      if (target) send(target.ws, { t: 'HOST_DENIED', from: ws.peerId });
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.room) return;
    const r = rooms.get(ws.room);
    if (!r) return;
    const wasLeader = r.leader === ws.peerId;
    r.members = r.members.filter((m) => m.ws !== ws);
    if (r.members.length === 0) {
      rooms.delete(ws.room);
      console.log(`[sig] ${ws.peerId} left room=${ws.room} (empty, removed)`);
      return;
    }
    broadcastRoom(ws.room, { t: 'PEER_LEFT', peerId: ws.peerId });
    if (wasLeader) {
      // Promote next-oldest peer (members already sorted by join order).
      r.leader = r.members[0].peerId;
      console.log(`[sig] leader left; promoted ${r.leader} (room=${ws.room})`);
      broadcastRoleAssign(ws.room);
    }
    console.log(`[sig] ${ws.peerId} left room=${ws.room} (size=${r.members.length})`);
  });
});

const ips = lanIps();
console.log(`[sig] listening on port ${PORT}`);
console.log(`[sig] reach from extension as:`);
console.log(`        ws://localhost:${PORT}        (same machine)`);
for (const ip of ips) console.log(`        ws://${ip}:${PORT}        (LAN)`);
