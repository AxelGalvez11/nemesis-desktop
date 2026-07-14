import { jsx as _jsx } from "react/jsx-runtime";
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '@/i18n/context';
import { AttachmentList } from './attachments';
function makeAttachment(id, label = 'test.pdf') {
    return { id, kind: 'file', label };
}
function renderWithI18n(ui) {
    return render(_jsx(I18nProvider, { configClient: { getConfig: async () => ({}), saveConfig: async () => ({ ok: true }) }, children: ui }));
}
describe('AttachmentList', () => {
    afterEach(() => {
        cleanup();
    });
    it('renders valid attachments', () => {
        const attachments = [makeAttachment('a', 'doc.pdf'), makeAttachment('b', 'img.png')];
        renderWithI18n(_jsx(AttachmentList, { attachments: attachments }));
        expect(screen.getByText('doc.pdf')).toBeDefined();
        expect(screen.getByText('img.png')).toBeDefined();
    });
    it('renders empty list without error', () => {
        renderWithI18n(_jsx(AttachmentList, { attachments: [] }));
        // The component wraps its (possibly empty) attachment pills in a
        // `data-slot="composer-attachments"` div — this codebase's convention
        // for hooking DOM assertions (there is no `data-testid` anywhere in
        // src). `getByTestId` would throw before the `??` fallback ever ran;
        // `queryByTestId` returns null instead, letting the real query resolve.
        const container = screen.queryByTestId('composer-attachments') ?? document.querySelector('[data-slot="composer-attachments"]');
        expect(container).not.toBeNull();
    });
    it('does not crash when attachments array contains undefined entries', () => {
        // Repro: session switch can leave stale/undefined entries in the
        // attachments array, causing a TypeError at attachment.refText.
        const attachments = [
            makeAttachment('a', 'good.pdf'),
            undefined,
            makeAttachment('b', 'also-good.png')
        ];
        expect(() => {
            renderWithI18n(_jsx(AttachmentList, { attachments: attachments }));
        }).not.toThrow();
        // Only valid attachments should render
        expect(screen.getByText('good.pdf')).toBeDefined();
        expect(screen.getByText('also-good.png')).toBeDefined();
    });
    it('does not crash when attachments array contains null entries', () => {
        const attachments = [null, makeAttachment('a', 'valid.txt')];
        expect(() => {
            renderWithI18n(_jsx(AttachmentList, { attachments: attachments }));
        }).not.toThrow();
        expect(screen.getByText('valid.txt')).toBeDefined();
    });
});
