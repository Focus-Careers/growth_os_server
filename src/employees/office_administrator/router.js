import { Router } from 'express';
import { createUserAndAccount } from './skills/sign_up_no_account/index.js';

const router = Router();

router.post('/sign-up-no-account', createUserAndAccount);

export default router;
