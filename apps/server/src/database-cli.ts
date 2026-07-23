import { closeDatabase, createDatabaseIfMissing, runMigrations, seedRootUser } from "./lib/database.js";

const command = process.argv[2];

try {
  if (command === "create") {
    await createDatabaseIfMissing();
    console.log("Database schema is ready.");
  } else if (command === "migrate") {
    await runMigrations();
    console.log("Migrations applied.");
  } else if (command === "seed") {
    await seedRootUser();
    console.log("Root user is ready.");
  } else {
    throw new Error("Expected one of: create, migrate, seed");
  }
} finally {
  await closeDatabase();
}
