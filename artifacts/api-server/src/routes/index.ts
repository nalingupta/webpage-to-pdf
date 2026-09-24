import { Router, type IRouter } from "express";
import healthRouter from "./health";
import pdfRouter from "./pdf";

const router: IRouter = Router();

router.use(healthRouter);
router.use(pdfRouter);

export default router;
