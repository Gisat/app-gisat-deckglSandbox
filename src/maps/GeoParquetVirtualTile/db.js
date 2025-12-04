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
    const FILE_URL = "http://127.0.0.1:8080/egms_tiered_v2.geoparquet";
    // const FILE_URL = "http://127.0.0.1:8080/egms_viz_layer.geoparquet";

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
