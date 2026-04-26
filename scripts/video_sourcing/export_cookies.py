"""Export YouTube cookies from Edge browser to Netscape cookies.txt format."""

import http.cookiejar
import browser_cookie3

COOKIES_FILE = "cookies.txt"


def export_edge_cookies():
    """Extract YouTube cookies from Edge and save as Netscape cookies.txt."""
    print("Extracting cookies from Edge browser...", flush=True)
    print("(Make sure Edge is CLOSED before running this)", flush=True)

    try:
        cj = browser_cookie3.edge(domain_name=".youtube.com")
    except Exception as e:
        print(f"Edge failed: {e}", flush=True)
        print("Trying Chrome...", flush=True)
        try:
            cj = browser_cookie3.chrome(domain_name=".youtube.com")
        except Exception as e2:
            print(f"Chrome also failed: {e2}", flush=True)
            return False

    # Save as Netscape format cookies.txt
    cookie_count = 0
    with open(COOKIES_FILE, "w") as f:
        f.write("# Netscape HTTP Cookie File\n")
        for cookie in cj:
            if ".youtube.com" in cookie.domain or ".google.com" in cookie.domain:
                secure = "TRUE" if cookie.secure else "FALSE"
                domain_dot = "TRUE" if cookie.domain.startswith(".") else "FALSE"
                expires = str(cookie.expires) if cookie.expires else "0"
                f.write(f"{cookie.domain}\t{domain_dot}\t{cookie.path}\t{secure}\t{expires}\t{cookie.name}\t{cookie.value}\n")
                cookie_count += 1

    print(f"Exported {cookie_count} cookies to {COOKIES_FILE}", flush=True)
    return cookie_count > 0


if __name__ == "__main__":
    export_edge_cookies()
