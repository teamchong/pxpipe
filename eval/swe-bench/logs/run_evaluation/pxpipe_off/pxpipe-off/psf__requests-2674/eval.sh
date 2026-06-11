#!/bin/bash
set -uxo pipefail
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
git config --global --add safe.directory /testbed
cd /testbed
git status
git show
git -c core.fileMode=false diff 0be38a0c37c59c4b66ce908731da15b401655113
source /opt/miniconda3/bin/activate
conda activate testbed
python -m pip install .
git checkout 0be38a0c37c59c4b66ce908731da15b401655113 test_requests.py
git apply -v - <<'EOF_114329324912'
diff --git a/test_requests.py b/test_requests.py
--- a/test_requests.py
+++ b/test_requests.py
@@ -1655,6 +1655,16 @@ def test_urllib3_retries():
     with pytest.raises(RetryError):
         s.get(httpbin('status/500'))
 
+
+def test_urllib3_pool_connection_closed():
+    s = requests.Session()
+    s.mount('http://', HTTPAdapter(pool_connections=0, pool_maxsize=0))
+
+    try:
+        s.get(httpbin('status/200'))
+    except ConnectionError as e:
+        assert u"HTTPConnectionPool(host='httpbin.org', port=80): Pool is closed." in str(e.message)
+
 def test_vendor_aliases():
     from requests.packages import urllib3
     from requests.packages import chardet

EOF_114329324912
: '>>>>> Start Test Output'
pytest -rA test_requests.py
: '>>>>> End Test Output'
git checkout 0be38a0c37c59c4b66ce908731da15b401655113 test_requests.py
