import React from 'react';
import { Modal } from './Modal';

type Props = {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  /** Destructive action styling (delete) */
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/** In-app confirm dialog — replaces window.confirm */
export function ConfirmModal({
  title,
  message,
  confirmLabel = 'Удалить',
  cancelLabel = 'Отмена',
  busy = false,
  danger = true,
  onConfirm,
  onClose,
}: Props) {
  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      <div className="modal-confirm">
        {danger && (
          <div className="modal-confirm-icon" aria-hidden>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M3 6h18" />
              <path d="M8 6V4h8v2" />
              <path d="M19 6l-1 14H6L5 6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </div>
        )}
        <p className="modal-confirm-text">{message}</p>
        <div className="modal-actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`btn solid ${danger ? 'danger' : ''}`}
            disabled={busy}
            onClick={onConfirm}
            autoFocus
          >
            {busy ? '…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
