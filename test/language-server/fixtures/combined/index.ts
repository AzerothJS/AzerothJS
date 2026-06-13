export { default as Modal, MODAL_KIND } from './modal.component.azeroth';
export type { ModalProps } from './modal.component.azeroth';
import Modal2, { MODAL_KIND as K } from './modal.component.azeroth';
import type { ModalProps as MP } from './modal.component.azeroth';
const ok: MP = { title: 'Hi', open: () => true };
const kind: string = K;
const el = Modal2({ title: 'x', open: () => false });
void ok; void kind; void el;
