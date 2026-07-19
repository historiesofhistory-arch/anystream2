import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import proxyRouter from "./proxy.js";
import hlsRouter from "./hls.js";
import echoRouter from "./echo.js";
import animeRouter from "./anime.js";
import anilistRouter from "./anilist.js";
import streamRouter from "./stream.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(proxyRouter);
router.use(hlsRouter);
router.use(echoRouter);
router.use(animeRouter);
router.use(anilistRouter);
router.use(streamRouter);

export default router;
