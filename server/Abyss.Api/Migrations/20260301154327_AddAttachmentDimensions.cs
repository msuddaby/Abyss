using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Abyss.Api.Migrations
{
    /// <inheritdoc />
    public partial class AddAttachmentDimensions : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "Height",
                table: "Attachments",
                type: "integer",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "Width",
                table: "Attachments",
                type: "integer",
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Height",
                table: "Attachments");

            migrationBuilder.DropColumn(
                name: "Width",
                table: "Attachments");
        }
    }
}
