import path from "path";
import Config from "../common/Config";

/**
 * Absolute path of the structure-conversion helper.
 *
 * Was `path.join(process.cwd(), Config.BIN_PATH, ...)`, which silently pointed at the
 * wrong place whenever the server was started from another working directory. BIN_PATH
 * is already absolute since 3.0, so joining is enough.
 */
export const CLI_EXE_PATH = path.join(Config.BIN_PATH, "CALL-CLI.exe")