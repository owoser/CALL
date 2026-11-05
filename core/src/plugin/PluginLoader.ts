import Config from "../common/Config";
import * as fs from "fs";
import * as path from "path";
import { IPlugin, PluginTool } from "./Plugin";

export class PluginLoader {
    public static idList: string[] = [];
    public static pluginsMap = new Map<string, IPlugin>();

    public loadPlugins() {
        const files = fs.readdirSync(Config.SHAPES_PATH);

        for (const fileName of files) {
            if (!fileName.endsWith(".js")) continue;
            // Absolute path: the old code hardcoded "../../../userdata/plugins/", which
            // silently broke every shape pack once the directory moved to data/shapes/.
            const fullPath = path.join(Config.SHAPES_PATH, fileName);

            try {
                const PluginClass: new (tool: PluginTool) => IPlugin = require(fullPath).default;
                
                const tool = new PluginTool()
                const instance = new PluginClass(tool);
                tool.setPlugin(instance);

                const id = instance.getId();
                PluginLoader.pluginsMap.set(id, instance);
                PluginLoader.idList.push(id);

                logger.log(`Module loaded: ${fileName}`);
            } catch (error) {
                logger.error(`Error loading module: ${fileName}`, error);
            }
        }
    }
}
