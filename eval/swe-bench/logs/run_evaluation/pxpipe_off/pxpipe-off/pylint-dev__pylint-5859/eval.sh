#!/bin/bash
set -uxo pipefail
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
git config --global --add safe.directory /testbed
cd /testbed
git status
git show
git -c core.fileMode=false diff 182cc539b8154c0710fcea7e522267e42eba8899
source /opt/miniconda3/bin/activate
conda activate testbed
python -m pip install -e .
git checkout 182cc539b8154c0710fcea7e522267e42eba8899 tests/checkers/unittest_misc.py
git apply -v - <<'EOF_114329324912'
diff --git a/tests/checkers/unittest_misc.py b/tests/checkers/unittest_misc.py
--- a/tests/checkers/unittest_misc.py
+++ b/tests/checkers/unittest_misc.py
@@ -68,6 +68,16 @@ def test_without_space_fixme(self) -> None:
         ):
             self.checker.process_tokens(_tokenize_str(code))
 
+    @set_config(notes=["???"])
+    def test_non_alphanumeric_codetag(self) -> None:
+        code = """a = 1
+                #???
+                """
+        with self.assertAddsMessages(
+            MessageTest(msg_id="fixme", line=2, args="???", col_offset=17)
+        ):
+            self.checker.process_tokens(_tokenize_str(code))
+
     @set_config(notes=[])
     def test_absent_codetag(self) -> None:
         code = """a = 1

EOF_114329324912
: '>>>>> Start Test Output'
pytest -rA tests/checkers/unittest_misc.py
: '>>>>> End Test Output'
git checkout 182cc539b8154c0710fcea7e522267e42eba8899 tests/checkers/unittest_misc.py
