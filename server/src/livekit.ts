// One-minute passes for the test call. A pass lets its holder into one room only:
// the sender may publish sound and nothing else, the listener may only listen.

import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { config, type LiveKitKeys } from './config.js';

export interface CallPass { region: string; url: string; room: string; send: string; listen: string }

export function callRegion(preferred: string | null): { id: string; keys: LiveKitKeys } | null {
  if (preferred && config.livekit.has(preferred)) return { id: preferred, keys: config.livekit.get(preferred)! };
  const first = config.livekit.has(config.mainRegion) ? config.mainRegion : [...config.livekit.keys()][0];
  return first ? { id: first, keys: config.livekit.get(first)! } : null;
}

export async function makePass(testId: string, preferred: string | null): Promise<CallPass | null> {
  const where = callRegion(preferred);
  if (!where) return null;
  const { key, secret, url } = where.keys;
  const room = `nettest-${testId}`;
  // Best effort: a room that holds two and closes itself. If this fails, the room is made on join.
  try {
    const api = new RoomServiceClient(url.replace(/^ws/, 'http'), key, secret);
    await Promise.race([
      api.createRoom({ name: room, emptyTimeout: 20, departureTimeout: 5, maxParticipants: 2 }),
      new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 3000)),
    ]);
  } catch { /* fine */ }
  const pass = async (identity: string, send: boolean) => {
    const t = new AccessToken(key, secret, { identity, ttl: 120 });
    t.addGrant({
      roomJoin: true, room, roomCreate: false,
      canPublish: send, canSubscribe: !send, canPublishData: false, canUpdateOwnMetadata: false,
    });
    return t.toJwt();
  };
  return { region: where.id, url, room, send: await pass(`send-${testId.slice(0, 8)}`, true), listen: await pass(`listen-${testId.slice(0, 8)}`, false) };
}
