#!/usr/bin/env node
// Project-local Stop hook. Part of the enforcement layer.
// A tick is finished when it has reached its terminal step.
import { readFileSync } from 'fs';

const state = JSON.parse(readFileSync(process.env.TICK_STATE_PATH, 'utf8'));
const finished = state.step >= 9;
process.stdout.write(JSON.stringify({ preventedContinuation: !finished }) + '\n');
