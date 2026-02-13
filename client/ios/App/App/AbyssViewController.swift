import UIKit
import Capacitor
import WebKit

class AbyssViewController: CAPBridgeViewController, WKNavigationDelegate {

    override func viewDidLoad() {
        super.viewDidLoad()
        #if DEBUG
        webView?.navigationDelegate = self
        #endif
    }

    #if DEBUG
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
           let serverTrust = challenge.protectionSpace.serverTrust {
            completionHandler(.useCredential, URLCredential(trust: serverTrust))
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }
    #endif
}
