#!/usr/bin/env node
import { cli } from "./common/cli.js";
import { createService } from "./plan.js";
await cli("pi-autoplan", createService);
