// src/db.js
import * as duckdb from "@duckdb/duckdb-wasm";
import { initializeDuckDb } from "duckdb-wasm-kit";

export async function setupDB() {
    const config = {
        query: {
            castBigIntToDouble: true,
        },
    };
    const db = await initializeDuckDb({ config, debug: true });

    // Use your actual file name and S3 URL here
    const file = "data_subset.geoparquet";
    const url = "https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/egms_hybrid_subset.geoparquet";

    await db.registerFileURL(
        file,
        url,
        duckdb.DuckDBDataProtocol.HTTP,
        true
    );

    const conn = await db.connect();
    console.log("installing extensions");

    // --- UPDATED ---
    // Install BOTH extensions
    await conn.query("INSTALL httpfs;");
    await conn.query("INSTALL spatial;");
    // --- END UPDATE ---

    await conn.close();
    console.log("DB setup complete.");
}
