trait ExistingWindow {
    fn show_existing(&self);
    fn unminimize_existing(&self);
    fn focus_existing(&self);
}

impl ExistingWindow for tauri::WebviewWindow {
    fn show_existing(&self) {
        let _ = self.show();
    }

    fn unminimize_existing(&self) {
        let _ = self.unminimize();
    }

    fn focus_existing(&self) {
        let _ = self.set_focus();
    }
}

fn reveal_window<W: ExistingWindow>(window: Option<&W>) {
    let Some(window) = window else {
        return;
    };
    window.show_existing();
    window.unminimize_existing();
    window.focus_existing();
}

pub(crate) fn reveal_main_window(app: &tauri::AppHandle) {
    use tauri::Manager;

    let window = app.get_webview_window("main");
    reveal_window(window.as_ref());
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct FakeWindow {
        calls: RefCell<Vec<&'static str>>,
        fail_show: bool,
    }

    impl FakeWindow {
        fn calls(&self) -> Vec<&'static str> {
            self.calls.borrow().clone()
        }
    }

    impl ExistingWindow for FakeWindow {
        fn show_existing(&self) {
            self.calls.borrow_mut().push("show");
            if self.fail_show {
                return;
            }
        }

        fn unminimize_existing(&self) {
            self.calls.borrow_mut().push("unminimize");
        }

        fn focus_existing(&self) {
            self.calls.borrow_mut().push("focus");
        }
    }

    #[test]
    fn existing_window_is_shown_restored_and_focused() {
        let fake = FakeWindow::default();
        reveal_window(Some(&fake));
        assert_eq!(fake.calls(), vec!["show", "unminimize", "focus"]);
    }

    #[test]
    fn missing_main_window_is_a_noop() {
        reveal_window::<FakeWindow>(None);
    }

    #[test]
    fn a_failed_show_does_not_skip_restore_or_focus() {
        let fake = FakeWindow {
            fail_show: true,
            ..FakeWindow::default()
        };
        reveal_window(Some(&fake));
        assert_eq!(fake.calls(), vec!["show", "unminimize", "focus"]);
    }
}
