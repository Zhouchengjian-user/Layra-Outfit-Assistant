// 部署时手动初始化 MySQL：node scripts/init-db.mjs
import { createConnection } from "mysql2/promise";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = await readFile(join(root, "db/mysql/0000_init.sql"), "utf8");

const connection = await createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "yida",
  multipleStatements: true,
});

await connection.query(sql);
console.log("✅ 数据库表结构初始化完成");
await connection.end();
