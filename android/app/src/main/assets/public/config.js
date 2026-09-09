// Cloud-sync configuration for the Appwrite backend.
//
// This file is committed on purpose -- a web project ID / database ID is not
// a secret (the collection's permissions are what actually gate access).
//
// While any value below is still an unfilled <PLACEHOLDER>, MealSync.isConfigured()
// returns false and the app runs exactly as it always has: pure localStorage,
// no login gate, no network calls. Fill these in once the Appwrite project
// exists (see the "Cloud sync (Appwrite)" section of README.md).
window.MEAL_SYNC_CONFIG = {
  endpoint: 'https://fra.cloud.appwrite.io/v1',
  projectId: '6aa1980c002f2e69c740',
  databaseId: '6aa1a8a2000b961f8b47',
  collectionId: '6aa1a9440033c53c5f6e',
};
