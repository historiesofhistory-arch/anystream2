import express, { type Express } from "express";
import cors from "cors";
import compression from "compression";
import pinoHttp from "pino-http";
import router from "./routes/index.js";
import homeRouter from "./routes/home.js";
import { logger } from "./lib/logger.js";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return { id: req.id, method: req.method, url: req.url?.split("?")[0] };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(compression()); // gzip all text responses — cuts transfer size ~70%
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Front page — served at "/" (Vercel/direct) and "/api" (Replit/proxied)
app.use("/", homeRouter);
app.use("/api", homeRouter);
// API routes
app.use("/api", router);

export default app;
