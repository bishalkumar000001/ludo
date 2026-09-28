import { Router, type IRouter } from "express";
import { CreateRoomBody, CreateRoomResponse, GetRoomParams, GetRoomResponse } from "@workspace/api-zod";
import { createLudoRoom, getLudoRoom, roomView } from "../realtime/ludo";

const router: IRouter = Router();

router.post("/rooms", (req, res) => {
  const parsed = CreateRoomBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "A player name and id are required" });
    return;
  }
  const room = createLudoRoom(parsed.data);
  res.status(201).json(CreateRoomResponse.parse(room));
});

router.get("/rooms/:roomCode", (req, res) => {
  const params = GetRoomParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid room code" });
    return;
  }
  const room = getLudoRoom(params.data.roomCode);
  if (!room) {
    res.status(404).json({ error: "Room not found or expired" });
    return;
  }
  res.json(GetRoomResponse.parse(roomView(room)));
});

export default router;