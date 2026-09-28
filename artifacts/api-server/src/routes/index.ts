import { Router, type IRouter } from "express";
import healthRouter from "./health";
import ludoRouter from "./ludo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(ludoRouter);

export default router;
