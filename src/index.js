import express from 'express';
import dotenv from 'dotenv';
import signupProcessorRouter from './intelligence/signup_message_processor/router.js';
import mobilisationRouter from './mobilisations/router.js';
import officeAdministratorRouter from './employees/office_administrator/router.js';
import messagesRouter from './messages/router.js';
import skillsRouter from './skills/router.js';
import smartleadWebhookRouter from './webhooks/smartlead.js';
import campaignsRouter from './campaigns/router.js';
import userRouter from './user/router.js';
import itpRouter from './itp/router.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Webhooks (before auth middleware — external services call these)
app.use('/api/webhooks/smartlead', smartleadWebhookRouter);

app.get('/', (req, res) => {
  res.json({ status: 'GrowthOS API running' });
});

app.use('/api/signup-processor', signupProcessorRouter);
app.use('/api/mobilisation', mobilisationRouter);
app.use('/api/employee/office-administrator', officeAdministratorRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/skills', skillsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/user', userRouter);
app.use('/api/itp', itpRouter);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
});
