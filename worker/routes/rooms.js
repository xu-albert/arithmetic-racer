import { allocateRoomId } from "../../server/room-id.js";
import { issueAdmissionPass } from "../../server/admission-pass.js";
import { allowRequest } from "../rate-limit.js";
import { logError, KINDS } from "../logger.js";

const RATE_LIMIT_WINDOW_S = 60;

export async function handleCreateRoom(request, env) {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await allowRequest(env.ROOM_CREATE_IP_LIMIT, ip, "ROOM_CREATE_IP_LIMIT"))) {
    return Response.json({ error: "rate_limited" }, {
      status: 429,
      headers: { "retry-after": String(RATE_LIMIT_WINDOW_S) },
    });
  }
  const roomId = await allocateRoomId(env, {
    onError: (e, id) => logError(KINDS.ROOM_CLAIM_FAILED, e, { roomId: id }),
  });
  if (roomId == null) return Response.json({ error: "no room name available" }, { status: 503 });
  try {
    const admissionPass = await issueAdmissionPass(env, roomId, "private");
    return Response.json({ roomId, admissionPass });
  } catch (e) {
    logError(KINDS.ROOM_CLAIM_FAILED, e, { roomId, phase: "admission_pass" });
    return Response.json({ error: "admission_unavailable" }, { status: 503 });
  }
}
