// Identifies this app run. Temp dirs and staging files carry it so the
// startup cleanup never touches artifacts that belong to the current run.
export const SESSION_ID: string = crypto.randomUUID();
