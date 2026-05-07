import { routePartykitRequest } from 'partyserver';
import { generateRoomId } from './room-id.js';

export { RaceRoom } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const roomId = generateRoomId();
      return Response.json({ roomId });
    }

    const partyResponse = await routePartykitRequest(request, env);
    if (partyResponse) return partyResponse;

    return env.ASSETS.fetch(request);
  },
};
