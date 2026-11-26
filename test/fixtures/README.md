# 测试字体 fixture

`cjk-subset.otf` 是 **Noto Sans CJK SC** 的子集，仅用于 PDF 导出的自动化测试：

- 来源：Noto Sans CJK SC（SIL Open Font License 1.1），从本机 `NotoSansCJK-Regular.ttc` 用 fontTools 子集化；
- 只保留测试会用到的一批汉字、标点与阿拉伯数字，体积约 11KB；
- 测试用它验证字体嵌入、中文文本提取与页码读取，**不要在运行时或产品里使用**。

许可证：SIL OFL 1.1，见上游 <https://github.com/notofonts/noto-cjk>。
