// Vertical rhythm around chat rows — the three class constants below are
// arithmetically coupled, so they live in one place instead of as magic
// numbers scattered across ChatView/MessageGroup. If you change either gap,
// re-derive the compensation.

/** Trailing padding under every virtualized row (ChatView's Virtuoso Item).
 *  Bottom padding instead of a margin/gap because react-virtuoso measures
 *  item heights from the wrapper box — see the comment at the Item component.
 *  Visually this is the 20px gap BETWEEN message groups. */
export const VIRTUOSO_ITEM_TRAILING_PAD = 'pb-5'; // 20px

/** Gap between rows INSIDE one message group (MessageGroup's root space-y). */
export const GROUP_CONTENT_GAP = 'space-y-4'; // 16px

/** The typing footer renders after the last row's trailing pad (20px), but it
 *  stands in for the group's next in-group row, which would sit at the
 *  group-content gap (16px). Compensate the difference so the hand-off from
 *  footer to in-group placeholder doesn't hop 4px (measured frame-by-frame
 *  from a screen recording). */
export const TYPING_FOOTER_GAP_COMPENSATION = '-mt-1'; // 4px = 20px − 16px
