// Use a static import so Vercel's file tracer includes the Express API and its
// runtime dependencies in the serverless function bundle.
import app from '../server/index.js';

export default app;
