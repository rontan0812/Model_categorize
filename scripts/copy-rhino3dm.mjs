// rhino3dm (Rhino .3dm の読み込みに使う WebAssembly) を public/ に置き、アプリと一緒に配信する
import { copyFileSync, mkdirSync } from "node:fs";

const dest = "public/rhino3dm";
mkdirSync(dest, { recursive: true });
for (const f of ["rhino3dm.js", "rhino3dm.wasm"]) copyFileSync(`node_modules/rhino3dm/${f}`, `${dest}/${f}`);
