/**
 * Compatibility aliases for the legacy HelperLib type names.
 *
 * CALL was written against LiteLoaderBDS' HelperLib, whose declarations named the
 * script classes `LLSE_Player`, `LLSE_Item` and `LLSE_Block`. Modern
 * LegacyScriptEngine declarations (@see types/lse) call them `Player`, `Item` and
 * `Block`.
 *
 * Instead of touching ~80 call sites in one go, we alias the old names here.
 * New code must use the modern names; these aliases are a migration aid and may be
 * removed once no source file references them.
 */

type LLSE_Player = Player;
type LLSE_Entity = Entity;
type LLSE_Block = Block;
type LLSE_Item = Item;
type LLSE_Container = Container;
type LLSE_BlockEntity = BlockEntity;
type LLSE_Objective = Objective;
type LLSE_IntPos = IntPos;
type LLSE_FloatPos = FloatPos;
type LLSE_DirectionAngle = DirectionAngle;
