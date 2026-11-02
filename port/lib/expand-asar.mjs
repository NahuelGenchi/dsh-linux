// Runs under the install's own binary from install.sh: node expand-asar.mjs <app.asar>
import { expandAsarInPlace } from './asar.mjs';

expandAsarInPlace(process.argv[2]);
