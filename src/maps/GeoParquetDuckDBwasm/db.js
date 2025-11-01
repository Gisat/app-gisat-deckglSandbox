import * as duckdb from "@duckdb/duckdb-wasm";
import { initializeDuckDb } from "duckdb-wasm-kit";

export async function setupDB() {
    const config = {
        query: {
            castBigIntToDouble: true,
        },
    };
    const db = await initializeDuckDb({ config, debug: true });

    // --- 1. Your optimized file (for the real app) ---
    // This URL should point to your subset or your full optimized file
    // const YOUR_FILE_URL = "https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/egms_hybrid_subset.geoparquet";
    // const YOUR_FILE_URL = "https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/egms_hybrid_optimized.geoparquet";
    const YOUR_FILE_URL = "https://eu-central-1.linodeobjects.com/gisat-data/3DFlusCCN_GST-93/project/data_geoparquet/UC5_PRAHA_EGMS/t146/egms_hybrid_optimized_bbox.geoparquet";
    // This is the internal name used in your SQL queries
    const YOUR_FILE_NAME = "data_subset.geoparquet";

    await db.registerFileURL(
        YOUR_FILE_NAME,
        YOUR_FILE_URL,
        duckdb.DuckDBDataProtocol.HTTP,
        true
    );

    const conn = await db.connect();
    console.log("installing extensions");
    await conn.query("INSTALL httpfs;");
    await conn.query("INSTALL spatial;");
    await conn.close();
    console.log("✅ DB setup complete. File registered:", YOUR_FILE_NAME);
}
