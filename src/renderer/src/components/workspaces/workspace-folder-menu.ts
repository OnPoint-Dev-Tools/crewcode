export function hasWorkspaceFolderDestination(
  knownFolders: readonly string[],
  currentFolder?: string | null,
): boolean {
  return knownFolders.some(folder => folder !== currentFolder)
}
