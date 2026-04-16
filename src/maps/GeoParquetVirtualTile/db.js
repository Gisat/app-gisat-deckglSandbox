import * as duckdb from "@duckdb/duckdb-wasm";
import { initializeDuckDb } from "duckdb-wasm-kit";

export async function setupDB() {
    const config = {
        query: {
            castBigIntToDouble: true,
        },
    };

    const db = await initializeDuckDb({ config, debug: false });

    // 🛑 POINT TO THE NEW LOCAL SERVER (Port 8080)
    // We use 127.0.0.1 to match the http-server output
    const FILE_URL = "https://eu-central-1.linodeobjects.com/gisat-data/3DFlus_GST-22/app-gisat-deckglSandbox/vectors/geoparquet/UC5_PRAHA_EGMS/t146/SRC_DATA/egms_optimized.geoparquet";   

    console.log("📂 Registering Dedicated Local File:", FILE_URL);

    await db.registerFileURL(
        "data.geoparquet",
        FILE_URL,
        duckdb.DuckDBDataProtocol.HTTP,
        true
    );

    const conn = await db.connect();
    await conn.query("INSTALL httpfs;");
    await conn.query("INSTALL spatial;");
    await conn.close();

    console.log("✅ DB Initialized");
}
