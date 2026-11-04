export default class BlockType {
    public states: string;
    public type: string;
    
    constructor(type: string, states: string = "") {
        if(type == null) this.type = "minecraft:air";
        else this.type = type;
        
        if(states == null) this.states = "";
        else this.states = states;
    }

    public static nbtToStates(comp: NbtCompound): string {
        let keys = comp.getKeys();
        let str = "";

        if(keys.length == 0) return '[]';

        for(let key of keys) {
            let data = comp.getData(key);
            str += `"${key}"=`;
            switch (comp.getTypeOf(key)) {
                case NBT.Byte:
                    str += data ? 'true' : 'false';
                    break;
                case NBT.String:
                    str += `"${data}"`;
                    break;
                default:
                    str += data;
                    break;
            }
            str += ',';
        }

        return '[' + str.slice(0, -1) + ']';
    }

    public static generateFromBlock(block: LLSE_Block): BlockType {
        if(block == null) return new BlockType("minecraft:air", "");

        let nbt = block.getNbt().getTag("states") as NbtCompound;
        return new BlockType(block.type, BlockType.nbtToStates(nbt));
    }

    public static generateFromItem(item: LLSE_Item): BlockType {
        if(!item.isNull() && item.isBlock) {
            let nbt = (item.getNbt().getTag("Block") as NbtCompound).getTag("states") as NbtCompound;
            return new BlockType(item.type, BlockType.nbtToStates(nbt));
        }
        else {
            return new BlockType("minecraft:air", "");
        }
    }

    /**
     * Command-safe block argument.
     *
     * 1.x returned `type + " " + states` unconditionally, so a block without states
     * produced "minecraft:stone " and callers that appended more arguments ended up
     * with stray empty parameters ("... minecraft:stone  replace ..."), which the
     * command parser rejects.
     */
    public toString(): string {
        const type = (this.type ?? "").trim();
        const states = (this.states ?? "").trim();
        if (type === "") return "";
        if (states === "" || states === "[]") return type;
        return type + " " + states;
    }

    /** True when this instance can form a valid block argument. */
    public isValid(): boolean {
        const type = (this.type ?? "").trim();
        if (type === "") return false;
        return /^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(type);
    }

    public toFormatString(): string {
        return `${this.type} "${this.states.slice().replaceAll("\"", "\\\"")}"`
    }
}