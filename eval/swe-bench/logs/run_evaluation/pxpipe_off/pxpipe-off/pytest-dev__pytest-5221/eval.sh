#!/bin/bash
set -uxo pipefail
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
git config --global --add safe.directory /testbed
cd /testbed
git status
git show
git -c core.fileMode=false diff 4a2fdce62b73944030cff9b3e52862868ca9584d
source /opt/miniconda3/bin/activate
conda activate testbed
python -m pip install -e .
git checkout 4a2fdce62b73944030cff9b3e52862868ca9584d testing/python/fixtures.py
git apply -v - <<'EOF_114329324912'
diff --git a/testing/python/fixtures.py b/testing/python/fixtures.py
--- a/testing/python/fixtures.py
+++ b/testing/python/fixtures.py
@@ -3037,11 +3037,25 @@ def test_funcarg_compat(self, testdir):
 
     def test_show_fixtures(self, testdir):
         result = testdir.runpytest("--fixtures")
-        result.stdout.fnmatch_lines(["*tmpdir*", "*temporary directory*"])
+        result.stdout.fnmatch_lines(
+            [
+                "tmpdir_factory [[]session scope[]]",
+                "*for the test session*",
+                "tmpdir",
+                "*temporary directory*",
+            ]
+        )
 
     def test_show_fixtures_verbose(self, testdir):
         result = testdir.runpytest("--fixtures", "-v")
-        result.stdout.fnmatch_lines(["*tmpdir*--*tmpdir.py*", "*temporary directory*"])
+        result.stdout.fnmatch_lines(
+            [
+                "tmpdir_factory [[]session scope[]] -- *tmpdir.py*",
+                "*for the test session*",
+                "tmpdir -- *tmpdir.py*",
+                "*temporary directory*",
+            ]
+        )
 
     def test_show_fixtures_testmodule(self, testdir):
         p = testdir.makepyfile(

EOF_114329324912
: '>>>>> Start Test Output'
pytest -rA testing/python/fixtures.py
: '>>>>> End Test Output'
git checkout 4a2fdce62b73944030cff9b3e52862868ca9584d testing/python/fixtures.py
