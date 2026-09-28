// `import q from "./x.sql" with { type: "text" }` gives the file as a string (node --experimental-import-text).
declare module "*.sql" {
  const sql: string;
  export default sql;
}
