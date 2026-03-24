import express from 'express';
import dotenv from 'dotenv';
import signupProcessorRouter from './intelligence/signup_message_processor/router.js';
import mobilisationRouter from './mobilisations/router.js';
import officeAdministratorRouter from './employees/office_administrator/router.js';
import messagesRouter from './messages/router.js';
import skillsRouter from './skills/router.js';

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

app.get('/', (req, res) => {
  res.json({ status: 'GrowthOS API running' });
});

app.use('/api/signup-processor', signupProcessorRouter);
app.use('/api/mobilisation', mobilisationRouter);
app.use('/api/employee/office-administrator', officeAdministratorRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/skills', skillsRouter);

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[server] Unhandled rejection:', reason);
});
