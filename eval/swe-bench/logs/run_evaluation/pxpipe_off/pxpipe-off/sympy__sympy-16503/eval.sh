#!/bin/bash
set -uxo pipefail
source /opt/miniconda3/bin/activate
conda activate testbed
cd /testbed
git config --global --add safe.directory /testbed
cd /testbed
git status
git show
git -c core.fileMode=false diff a7e6f093c98a3c4783848a19fce646e32b6e0161
source /opt/miniconda3/bin/activate
conda activate testbed
python -m pip install -e .
git checkout a7e6f093c98a3c4783848a19fce646e32b6e0161 sympy/printing/pretty/tests/test_pretty.py
git apply -v - <<'EOF_114329324912'
diff --git a/sympy/printing/pretty/tests/test_pretty.py b/sympy/printing/pretty/tests/test_pretty.py
--- a/sympy/printing/pretty/tests/test_pretty.py
+++ b/sympy/printing/pretty/tests/test_pretty.py
@@ -4423,14 +4423,14 @@ def test_pretty_sum():
   n             \n\
 ______          \n\
 ╲               \n\
- ╲      ∞       \n\
-  ╲     ⌠       \n\
-   ╲    ⎮   n   \n\
-    ╲   ⎮  x  dx\n\
-    ╱   ⌡       \n\
-   ╱    -∞      \n\
-  ╱    k        \n\
- ╱              \n\
+ ╲              \n\
+  ╲     ∞       \n\
+   ╲    ⌠       \n\
+    ╲   ⎮   n   \n\
+    ╱   ⎮  x  dx\n\
+   ╱    ⌡       \n\
+  ╱     -∞      \n\
+ ╱     k        \n\
 ╱               \n\
 ‾‾‾‾‾‾          \n\
 k = 0           \
@@ -4474,14 +4474,14 @@ def test_pretty_sum():
 -∞                \n\
  ______           \n\
  ╲                \n\
-  ╲       ∞       \n\
-   ╲      ⌠       \n\
-    ╲     ⎮   n   \n\
-     ╲    ⎮  x  dx\n\
-     ╱    ⌡       \n\
-    ╱     -∞      \n\
-   ╱     k        \n\
-  ╱               \n\
+  ╲               \n\
+   ╲      ∞       \n\
+    ╲     ⌠       \n\
+     ╲    ⎮   n   \n\
+     ╱    ⎮  x  dx\n\
+    ╱     ⌡       \n\
+   ╱      -∞      \n\
+  ╱      k        \n\
  ╱                \n\
  ‾‾‾‾‾‾           \n\
  k = 0            \
@@ -4527,14 +4527,14 @@ def test_pretty_sum():
           -∞                         \n\
            ______                    \n\
            ╲                         \n\
-            ╲                ∞       \n\
-             ╲               ⌠       \n\
-              ╲              ⎮   n   \n\
-               ╲             ⎮  x  dx\n\
-               ╱             ⌡       \n\
-              ╱              -∞      \n\
-             ╱              k        \n\
-            ╱                        \n\
+            ╲                        \n\
+             ╲               ∞       \n\
+              ╲              ⌠       \n\
+               ╲             ⎮   n   \n\
+               ╱             ⎮  x  dx\n\
+              ╱              ⌡       \n\
+             ╱               -∞      \n\
+            ╱               k        \n\
            ╱                         \n\
            ‾‾‾‾‾‾                    \n\
      2        2       1   x          \n\
@@ -4572,14 +4572,14 @@ def test_pretty_sum():
                   x   n          \n\
          ______                  \n\
          ╲                       \n\
-          ╲              ∞       \n\
-           ╲             ⌠       \n\
-            ╲            ⎮   n   \n\
-             ╲           ⎮  x  dx\n\
-             ╱           ⌡       \n\
-            ╱            -∞      \n\
-           ╱            k        \n\
-          ╱                      \n\
+          ╲                      \n\
+           ╲             ∞       \n\
+            ╲            ⌠       \n\
+             ╲           ⎮   n   \n\
+             ╱           ⎮  x  dx\n\
+            ╱            ⌡       \n\
+           ╱             -∞      \n\
+          ╱             k        \n\
          ╱                       \n\
          ‾‾‾‾‾‾                  \n\
          k = 0                   \
@@ -4602,8 +4602,8 @@ def test_pretty_sum():
   ∞    \n\
  ___   \n\
  ╲     \n\
-  ╲   x\n\
-  ╱    \n\
+  ╲    \n\
+  ╱   x\n\
  ╱     \n\
  ‾‾‾   \n\
 x = 0  \
@@ -4655,10 +4655,10 @@ def test_pretty_sum():
   ∞    \n\
  ____  \n\
  ╲     \n\
-  ╲   x\n\
-   ╲  ─\n\
-   ╱  2\n\
-  ╱    \n\
+  ╲    \n\
+   ╲  x\n\
+   ╱  ─\n\
+  ╱   2\n\
  ╱     \n\
  ‾‾‾‾  \n\
 x = 0  \
@@ -4716,12 +4716,12 @@ def test_pretty_sum():
   ∞           \n\
 _____         \n\
 ╲             \n\
- ╲           n\n\
-  ╲   ⎛    x⎞ \n\
-   ╲  ⎜    ─⎟ \n\
-   ╱  ⎜ 3  2⎟ \n\
-  ╱   ⎝x ⋅y ⎠ \n\
- ╱            \n\
+ ╲            \n\
+  ╲          n\n\
+   ╲  ⎛    x⎞ \n\
+   ╱  ⎜    ─⎟ \n\
+  ╱   ⎜ 3  2⎟ \n\
+ ╱    ⎝x ⋅y ⎠ \n\
 ╱             \n\
 ‾‾‾‾‾         \n\
 x = 0         \
@@ -4844,14 +4844,14 @@ def test_pretty_sum():
     ∞          n                         \n\
   ______   ______                        \n\
   ╲        ╲                             \n\
-   ╲        ╲     ⎛        1    ⎞        \n\
-    ╲        ╲    ⎜1 + ─────────⎟        \n\
-     ╲        ╲   ⎜          1  ⎟        \n\
-      ╲        ╲  ⎜    1 + ─────⎟     1  \n\
-      ╱        ╱  ⎜            1⎟ + ─────\n\
-     ╱        ╱   ⎜        1 + ─⎟       1\n\
-    ╱        ╱    ⎝            k⎠   1 + ─\n\
-   ╱        ╱                           k\n\
+   ╲        ╲                            \n\
+    ╲        ╲    ⎛        1    ⎞        \n\
+     ╲        ╲   ⎜1 + ─────────⎟        \n\
+      ╲        ╲  ⎜          1  ⎟     1  \n\
+      ╱        ╱  ⎜    1 + ─────⎟ + ─────\n\
+     ╱        ╱   ⎜            1⎟       1\n\
+    ╱        ╱    ⎜        1 + ─⎟   1 + ─\n\
+   ╱        ╱     ⎝            k⎠       k\n\
   ╱        ╱                             \n\
   ‾‾‾‾‾‾   ‾‾‾‾‾‾                        \n\
       1   k = 111                        \n\

EOF_114329324912
: '>>>>> Start Test Output'
PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose sympy/printing/pretty/tests/test_pretty.py
: '>>>>> End Test Output'
git checkout a7e6f093c98a3c4783848a19fce646e32b6e0161 sympy/printing/pretty/tests/test_pretty.py
