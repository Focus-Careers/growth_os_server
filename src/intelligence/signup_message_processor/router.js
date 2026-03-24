import { Router } from 'express';
import { processSignup } from './index.js';

const router = Router();

router.post('/', processSignup);

export default router;
