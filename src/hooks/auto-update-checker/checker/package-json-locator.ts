import { findAcceptedPackageJsonUp } from "../../../shared/observable-version"

export function findPackageJsonUp(startPath: string): string | null {
  return findAcceptedPackageJsonUp(startPath)
}
