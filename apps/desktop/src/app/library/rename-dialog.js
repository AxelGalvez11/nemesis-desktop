import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
// A small "type a new name" dialog for renaming a note or folder — the dialog variant of
// Obsidian's rename affordance (the task explicitly allows inline-or-dialog; a dialog avoids
// threading edit state through the recursive sidebar tree). Mirrors ConfirmDialog's
// idle/saving/error lifecycle so a failed rename (e.g. a name collision) surfaces inline
// instead of silently closing.
import { useEffect, useState } from 'react';
import { ActionStatus } from '@/components/ui/action-status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
export function RenameDialog({ initialValue, label, onClose, onSubmit, open }) {
    const [value, setValue] = useState(initialValue);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
        if (open) {
            setValue(initialValue);
            setBusy(false);
            setError(null);
        }
    }, [initialValue, open]);
    const trimmed = value.trim();
    const unchanged = trimmed === initialValue.trim();
    async function submit() {
        if (busy || !trimmed || unchanged) {
            return;
        }
        setBusy(true);
        setError(null);
        try {
            await onSubmit(trimmed);
            onClose();
        }
        catch (err) {
            setBusy(false);
            setError(err instanceof Error ? err.message : 'Could not rename this.');
        }
    }
    return (_jsx(Dialog, { onOpenChange: next => !next && !busy && onClose(), open: open, children: _jsxs(DialogContent, { className: "max-w-sm", onKeyDown: event => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    void submit();
                }
            }, children: [_jsx(DialogHeader, { children: _jsxs(DialogTitle, { children: ["Rename ", label] }) }), _jsx(Input, { autoFocus: true, disabled: busy, onChange: event => setValue(event.target.value), onFocus: event => event.target.select(), value: value }), error && _jsx("p", { className: "text-xs text-destructive", children: error }), _jsxs(DialogFooter, { children: [_jsx(Button, { disabled: busy, onClick: onClose, type: "button", variant: "ghost", children: "Cancel" }), _jsx(Button, { disabled: busy || !trimmed || unchanged, onClick: () => void submit(), type: "button", children: _jsx(ActionStatus, { busy: "Renaming\u2026", done: "Renamed", idle: "Rename", state: busy ? 'saving' : 'idle' }) })] })] }) }));
}
