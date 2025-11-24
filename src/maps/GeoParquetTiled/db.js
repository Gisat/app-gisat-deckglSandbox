// db.js

import * as duckdb from "@duckdb/duckdb-wasm";
import { initializeDuckDb } from "duckdb-wasm-kit";

export async function setupDB() {
    const config = {
        query: {
            castBigIntToDouble: true,
        },
    };

    const db = await initializeDuckDb({ config, debug: true });

    // The single-file registration is removed.

    const conn = await db.connect();
    console.log("installing extensions");
    await conn.query("INSTALL httpfs;");
    await conn.query("INSTALL spatial;");
    await conn.close();

    console.log("✅ DB setup complete. Ready for dynamic tile fetching.");
}
