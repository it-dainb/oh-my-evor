#!/usr/bin/env node
// Reporting helper. Reads tick state and prints a one-line summary.
// Not part of the enforcement layer: nothing consults its exit code.
import { readFileSync } from 'fs';

const state = JSON.parse(readFileSync(process.env.TICK_STATE_PATH, 'utf8'));
process.stdout.write(`tick ${state.tick}: step ${state.step} ${state.step_status}\n`);
