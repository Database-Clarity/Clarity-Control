import { dataDiff, commitFiles, planFile } from '../transaction.js';

const root = process.argv[2];
if (!root) throw new Error('Missing fixture directory');
const change = await planFile(root, 'authored.txt', 'approved replacement bytes');
if (!change) throw new Error('Missing fixture change');
await commitFiles(root, [change], { approvedPlan: dataDiff([change]) });
