import Lake
open Lake DSL

package «loom-formal» where
  srcDir := "."

lean_lib Loom where
  roots := #[`Loom]
