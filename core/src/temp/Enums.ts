import { MsgType } from "../util/Msg";

/**
 * Message types accepted by `Player.tell(msg, type)`.
 *
 * LegacyScriptEngine casts the number straight to BDS' TextPacketType, whose values are
 *   Raw=0, Chat=1, Translate=2, Popup=3, JukeboxPopup=4, Tip=5, SystemMessage=6, ...
 * LSE's own declarations (TextMessageType) however document popup = 4, and 1.x behaved
 * that way, so the public names below keep the historical numbers. Use them by name -
 * never a bare literal - so this stays a single place to change.
 */
export default class Enums {
    public static msg = {
        /** Plain raw message. */
        RAW: MsgType.RAW,
        /** Chat-style message. */
        CHAT: MsgType.CHAT,
        /** Popup above the hotbar (BDS JukeboxPopup == 4, see note above). */
        POPUP: MsgType.POPUP,
        /** Text shown in the tip/subtitle area. */
        TIP: MsgType.TIP,
        /**
         * TextObject. The message body MUST be a valid rawtext JSON document
         * ({"rawtext":[{"text":"..."}]}) or the client rejects the packet.
         * Prefer Msg.tellRaw() which validates this for you.
         */
        JSON: MsgType.JSON
    }

    public static DIRECTION = {
        NEG_Y: 0,
        POS_Y: 1,
        NEG_Z: 2,
        POS_Z: 3,
        NEG_X: 4,
        POS_X: 5
    }
}
