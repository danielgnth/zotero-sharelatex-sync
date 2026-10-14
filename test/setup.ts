// Keep test output readable: application logs are only shown with TEST_LOGS=1.
import { setLogSink } from "../src/log.ts";

if (!process.env.TEST_LOGS) setLogSink(() => {});
