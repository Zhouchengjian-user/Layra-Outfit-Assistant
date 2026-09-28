type TryOnItem = { name: string; category: string };

export function buildTryOnPrompt(items: TryOnItem[], scene: string, userPrompt: string, hasPersonalPhoto: boolean, gender = "其他") {
  const references = items.map((item, index) => `图${index + (hasPersonalPhoto ? 2 : 1)}是${item.name}（${item.category}）`).join("；");
  const model = hasPersonalPhoto
    ? "图1是用户全身照。请保持人物的脸、发型、肤色、身材比例和自然姿态"
    : `请生成一位${gender === "男" ? "男性" : gender === "女" ? "女性" : "中性"}不露脸的成年假人模特，姿态自然，不显示可辨识的人脸`;
  return `${hasPersonalPhoto ? "图1是用户全身照；" : ""}${references}。${model}，将全部参考单品按真实类别穿戴到模特身上：不得遗漏、替换或新增单品，保留每件的主色、版型、长度、材质、纹理和图案。从头到脚完整入镜。场景：${scene}。补充要求：${userPrompt}。写实服装摄影，浅灰影棚，柔和自然光，无文字、水印、边框、多人或多余肢体。`;
}
